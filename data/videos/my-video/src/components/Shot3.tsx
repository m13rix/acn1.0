import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
} from 'remotion';
import React from 'react';

export const Shot3: React.FC = () => {
	const frame = useCurrentFrame();
	const {fps, durationInFrames} = useVideoConfig();

	// Fly-through movement: Scale up to simulate moving forward
	// Instruction mentioned 0-8s, but shot is 5.33s. We map the movement to the actual duration.
	const scale = interpolate(frame, [0, durationInFrames], [1, 1.4], {
		extrapolateRight: 'clamp',
	});

	// Door Labels Data
	// Assuming doors are positioned left, center, right or similar in the image.
	// Since we don't know the exact image layout, we'll position them reasonably.
	const doors = [
		{label: 'Глава 3', delay: 1 * fps, x: '20%', y: '50%'},
		{label: 'Глава 4', delay: 2 * fps, x: '50%', y: '50%'},
		{label: 'Глава 5', delay: 3 * fps, x: '80%', y: '50%'},
	];

	return (
		<AbsoluteFill style={{backgroundColor: 'black', overflow: 'hidden'}}>
			{/* Container for the Zoom/Fly-through effect */}
			<AbsoluteFill
				style={{
					transform: `scale(${scale})`,
					transformOrigin: 'center center',
				}}
			>
				<Img
					src={staticFile('corridor_three_doors.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>

				{/* Door Labels */}
				{doors.map((door, index) => {
					const opacity = interpolate(
						frame,
						[door.delay, door.delay + 15],
						[0, 1],
						{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
					);

					// Glow effect pulsing after appearance
					const pulseFrame = (frame - door.delay) % 60; // 2 second pulse loop
					const glowIntensity = interpolate(
						pulseFrame,
						[0, 30, 60],
						[10, 20, 10],
						{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
					);

					return (
						<div
							key={index}
							className="absolute text-white font-bold"
							style={{
								left: door.x,
								top: door.y,
								transform: 'translate(-50%, -50%)', // Center on coordinate
								opacity,
								fontSize: 40,
								fontFamily: 'Inter, sans-serif',
								textShadow: `0 0 ${glowIntensity}px rgba(255, 215, 0, 0.8), 0 0 ${glowIntensity * 2}px rgba(255, 140, 0, 0.6)`,
							}}
						>
							{door.label}
						</div>
					);
				})}
				
				{/* Golden Hour Overlay (attached to scene or camera? 
				    Usually lighting is global/camera based, but if we want it to feel like the scene is lit, 
					it can be here. Let's put it OUTSIDE the scale if it's a lens effect, 
					or INSIDE if it's the environment. 
					"Warm golden hour lighting" implies environment. 
					However, a simple overlay works best on top of everything.
					Let's move it outside for a consistent "filter" look or keep here to scale with image noise?
					Overlay usually sits on top.
				*/}
			</AbsoluteFill>

			{/* Golden Hour Overlay - Global */}
			<AbsoluteFill
				style={{
					backgroundColor: 'rgba(255, 160, 0, 0.3)', // Orange/Gold
					mixBlendMode: 'overlay',
					pointerEvents: 'none',
				}}
			/>
			{/* Additional Warmth gradient */}
			<AbsoluteFill
				style={{
					background: 'linear-gradient(to bottom, rgba(255, 200, 0, 0.1), rgba(255, 100, 0, 0.2))',
					mixBlendMode: 'soft-light',
					pointerEvents: 'none',
				}}
			/>

			<Audio src={staticFile('shot3_voice.mp3')} />
		</AbsoluteFill>
	);
};
