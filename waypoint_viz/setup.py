from setuptools import setup

package_name = 'waypoint_viz'

setup(
    name=package_name,
    version='0.0.1',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='Scott Hadzik',
    maintainer_email='shadzik@weber.edu',
    description='RViz visualization of CSV waypoints and pure pursuit lookahead point.',
    license='MIT',
    entry_points={
        'console_scripts': [
            'waypoint_viz_node = waypoint_viz.waypoint_viz_node:main',
        ],
    },
)
