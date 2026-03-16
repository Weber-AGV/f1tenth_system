# MIT License

# Copyright (c) 2025 WSU F1TENTH

# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:

# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.

# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare
from ament_index_python.packages import get_package_share_directory
import os


def generate_launch_description():
    f1tenth_stack_dir = get_package_share_directory('f1tenth_stack')
    nav2_bringup_dir = get_package_share_directory('nav2_bringup')

    map_name_arg = DeclareLaunchArgument(
        'map_name',
        default_value='lab_map',
        description='Map name (without extension) in f1tenth_stack/maps/'
    )

    nav2_params = os.path.join(f1tenth_stack_dir, 'config', 'nav2_params.yaml')
    map_file = PathJoinSubstitution(
        [FindPackageShare('f1tenth_stack'), 'maps', [LaunchConfiguration('map_name'), '.yaml']]
    )

    nav2_bringup = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(nav2_bringup_dir, 'launch', 'bringup_launch.py')
        ),
        launch_arguments={
            'map': map_file,
            'params_file': nav2_params,
            'use_sim_time': 'False',
            'slam': 'False',     # use AMCL for localization, not slam_toolbox
            'autostart': 'True',
        }.items()
    )

    # Converts nav2 cmd_vel (Twist) → drive (AckermannDriveStamped) for the mux
    cmd_vel_to_ackermann_node = Node(
        package='f1tenth_stack',
        executable='cmd_vel_to_ackermann',
        name='cmd_vel_to_ackermann',
        parameters=[{'wheelbase': 0.25}]
    )

    return LaunchDescription([map_name_arg, nav2_bringup, cmd_vel_to_ackermann_node])
